use std::{collections::HashMap, net::IpAddr, sync::Arc, time::Instant};

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
        if units_per_second == 0 || burst_seconds == 0 {
            return false;
        }

        let now = Instant::now();
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
    table.prune_if_due(now, &state.config);
    let limits = &mut table.entries;

    if !limits.contains_key(&ip) && limits.len() >= MAX_IP_LIMIT_ENTRIES {
        return false;
    }

    let entry = limits.entry(ip).or_insert_with(|| IpLimitEntry::new(now));
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

pub(crate) fn try_acquire_streamer_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<StreamerIpGuard>, &'static str> {
    if state.config.max_streamers_per_ip == 0 {
        return Ok(None);
    }

    let now = Instant::now();
    let mut table = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    table.prune_if_due(now, &state.config);
    let limits = &mut table.entries;

    if !limits.contains_key(&ip) && limits.len() >= MAX_IP_LIMIT_ENTRIES {
        return Err("too many tracked IPs\n");
    }

    let entry = limits.entry(ip).or_insert_with(|| IpLimitEntry::new(now));
    entry.last_seen = now;
    if entry.streamers >= state.config.max_streamers_per_ip {
        return Err("too many active streamers from this IP\n");
    }

    entry.streamers += 1;
    Ok(Some(StreamerIpGuard {
        state: state.clone(),
        ip,
    }))
}

pub(crate) fn try_acquire_listener_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<ListenerIpGuard>, &'static str> {
    if state.config.max_listeners_per_ip == 0 {
        return Ok(None);
    }

    let now = Instant::now();
    let mut table = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    table.prune_if_due(now, &state.config);
    let limits = &mut table.entries;

    if !limits.contains_key(&ip) && limits.len() >= MAX_IP_LIMIT_ENTRIES {
        return Err("453 Not Enough Bandwidth");
    }

    let entry = limits.entry(ip).or_insert_with(|| IpLimitEntry::new(now));
    entry.last_seen = now;
    if entry.listeners >= state.config.max_listeners_per_ip {
        return Err("453 Not Enough Bandwidth");
    }

    entry.listeners += 1;
    Ok(Some(ListenerIpGuard {
        state: state.clone(),
        ip,
    }))
}

pub(crate) struct StreamerIpGuard {
    state: Arc<AppState>,
    ip: IpAddr,
}

impl Drop for StreamerIpGuard {
    fn drop(&mut self) {
        let mut table = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = table.entries.get_mut(&self.ip) {
            entry.streamers = entry.streamers.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}

pub(crate) struct ListenerIpGuard {
    state: Arc<AppState>,
    ip: IpAddr,
}

impl Drop for ListenerIpGuard {
    fn drop(&mut self) {
        let mut table = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = table.entries.get_mut(&self.ip) {
            entry.listeners = entry.listeners.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}
