use std::{
    collections::{HashMap, hash_map::Entry},
    net::IpAddr,
    sync::{Arc, atomic::Ordering},
    time::Instant,
};

use super::{AppState, Config};

const MAX_IP_LIMIT_ENTRIES: usize = 8192;

struct IpLimitEntry {
    window_started: Instant,
    request_count: usize,
    streamers: usize,
    listeners: usize,
    last_seen: Instant,
}

pub(crate) struct IpLimitTable {
    entries: HashMap<IpAddr, IpLimitEntry>,
    last_pruned: Instant,
}

impl IpLimitTable {
    pub(crate) fn new() -> Self {
        Self {
            entries: HashMap::new(),
            last_pruned: Instant::now(),
        }
    }

    fn prune_if_due(&mut self, now: Instant, config: &Config) {
        if now.duration_since(self.last_pruned) < config.http_rate_limit_window {
            return;
        }
        self.last_pruned = now;
        let idle_timeout = config.http_rate_limit_window.saturating_mul(2);
        self.entries.retain(|_, entry| {
            entry.streamers != 0
                || entry.listeners != 0
                || now.duration_since(entry.last_seen) < idle_timeout
        });
    }

    fn entry(&mut self, ip: IpAddr, now: Instant, config: &Config) -> Option<&mut IpLimitEntry> {
        self.prune_if_due(now, config);
        let can_insert = self.entries.len() < MAX_IP_LIMIT_ENTRIES;
        match self.entries.entry(ip) {
            Entry::Occupied(entry) => Some(entry.into_mut()),
            Entry::Vacant(entry) if can_insert => Some(entry.insert(IpLimitEntry::new(now))),
            Entry::Vacant(_) => None,
        }
    }
}

impl IpLimitEntry {
    fn new(now: Instant) -> Self {
        Self {
            window_started: now,
            request_count: 0,
            streamers: 0,
            listeners: 0,
            last_seen: now,
        }
    }
}

pub(crate) struct TokenBucket {
    available: f64,
    updated_at: Instant,
    initialized: bool,
}

impl TokenBucket {
    pub(crate) fn new() -> Self {
        Self {
            available: 0.0,
            updated_at: Instant::now(),
            initialized: false,
        }
    }

    pub(crate) fn allow(
        &mut self,
        units: usize,
        units_per_second: usize,
        burst_seconds: usize,
    ) -> bool {
        self.allow_at(Instant::now(), units, units_per_second, burst_seconds)
    }

    pub(crate) fn allow_at(
        &mut self,
        now: Instant,
        units: usize,
        units_per_second: usize,
        burst_seconds: usize,
    ) -> bool {
        if units_per_second == 0 || burst_seconds == 0 {
            return false;
        }

        let capacity = units_per_second.saturating_mul(burst_seconds) as f64;
        if self.initialized {
            self.available = (self.available
                + now.duration_since(self.updated_at).as_secs_f64() * units_per_second as f64)
                .min(capacity);
        } else {
            self.available = capacity;
            self.initialized = true;
        }
        self.updated_at = now;

        if units as f64 > self.available {
            return false;
        }
        self.available -= units as f64;
        true
    }

    pub(crate) fn available_units(&self) -> usize {
        self.available.max(0.0) as usize
    }
}

pub(crate) fn allow_http_request(state: &Arc<AppState>, ip: IpAddr) -> bool {
    if state.config.max_http_requests_per_ip == 0 {
        return true;
    }

    let now = Instant::now();
    let mut table = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(entry) = table.entry(ip, now, &state.config) else {
        return false;
    };
    if now.duration_since(entry.window_started) >= state.config.http_rate_limit_window {
        entry.window_started = now;
        entry.request_count = 0;
    }

    entry.last_seen = now;
    if entry.request_count >= state.config.max_http_requests_per_ip {
        return false;
    }

    entry.request_count += 1;
    true
}

pub(crate) fn try_acquire_connection(
    state: &Arc<AppState>,
) -> Result<ConnectionGuard, &'static str> {
    state
        .active_connections
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (state.config.max_connections == 0 || current < state.config.max_connections)
                .then_some(current.saturating_add(1))
        })
        .map_err(|_| "too many active connections")?;

    Ok(ConnectionGuard {
        state: state.clone(),
    })
}

pub(crate) struct ConnectionGuard {
    state: Arc<AppState>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.state.active_connections.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) fn try_acquire_streamer_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<StreamerIpGuard>, &'static str> {
    try_acquire_ip(
        state,
        ip,
        IpConnectionKind::Streamer,
        state.config.max_streamers_per_ip,
        "too many tracked IPs\n",
        "too many active streamers from this IP\n",
    )
}

pub(crate) fn try_acquire_listener_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<ListenerIpGuard>, &'static str> {
    try_acquire_ip(
        state,
        ip,
        IpConnectionKind::Listener,
        state.config.max_listeners_per_ip,
        "453 Not Enough Bandwidth",
        "453 Not Enough Bandwidth",
    )
}

#[derive(Clone, Copy)]
enum IpConnectionKind {
    Streamer,
    Listener,
}

impl IpConnectionKind {
    fn count_mut(self, entry: &mut IpLimitEntry) -> &mut usize {
        match self {
            Self::Streamer => &mut entry.streamers,
            Self::Listener => &mut entry.listeners,
        }
    }
}

fn try_acquire_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
    kind: IpConnectionKind,
    limit: usize,
    table_full_error: &'static str,
    limit_error: &'static str,
) -> Result<Option<IpLimitGuard>, &'static str> {
    if limit == 0 {
        return Ok(None);
    }

    let now = Instant::now();
    let mut table = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(entry) = table.entry(ip, now, &state.config) else {
        return Err(table_full_error);
    };
    entry.last_seen = now;
    let count = kind.count_mut(entry);
    if *count >= limit {
        return Err(limit_error);
    }
    *count += 1;

    Ok(Some(IpLimitGuard {
        state: state.clone(),
        ip,
        kind,
    }))
}

pub(crate) struct IpLimitGuard {
    state: Arc<AppState>,
    ip: IpAddr,
    kind: IpConnectionKind,
}

impl Drop for IpLimitGuard {
    fn drop(&mut self) {
        let mut table = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = table.entries.get_mut(&self.ip) {
            let count = self.kind.count_mut(entry);
            *count = count.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}

pub(crate) type StreamerIpGuard = IpLimitGuard;
pub(crate) type ListenerIpGuard = IpLimitGuard;
