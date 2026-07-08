use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use super::{AppState, Config};

pub(crate) struct IpLimitEntry {
    window_started: Instant,
    request_count: usize,
    streamers: usize,
    listeners: usize,
    last_seen: Instant,
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

pub(crate) struct RateWindow {
    started: Instant,
    bytes: usize,
    window: Duration,
}

impl RateWindow {
    pub(crate) fn new(window: Duration) -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
            window,
        }
    }

    pub(crate) fn allow(&mut self, len: usize, bytes_per_sec: usize) -> bool {
        if self.started.elapsed() >= self.window {
            self.started = Instant::now();
            self.bytes = 0;
        }

        self.bytes = self.bytes.saturating_add(len);
        self.bytes <= bytes_per_sec.saturating_mul(self.window.as_secs() as usize)
    }
}

pub(crate) fn allow_http_request(state: &Arc<AppState>, ip: IpAddr) -> bool {
    if state.config.max_http_requests_per_ip == 0 {
        return true;
    }

    let now = Instant::now();
    let mut limits = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_ip_limits(&mut limits, now, &state.config);

    if !limits.contains_key(&ip)
        && state.config.max_tracked_ips != 0
        && limits.len() >= state.config.max_tracked_ips
    {
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
    let mut limits = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_ip_limits(&mut limits, now, &state.config);

    if !limits.contains_key(&ip)
        && state.config.max_tracked_ips != 0
        && limits.len() >= state.config.max_tracked_ips
    {
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
    let mut limits = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_ip_limits(&mut limits, now, &state.config);

    if !limits.contains_key(&ip)
        && state.config.max_tracked_ips != 0
        && limits.len() >= state.config.max_tracked_ips
    {
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

fn prune_ip_limits(limits: &mut HashMap<IpAddr, IpLimitEntry>, now: Instant, config: &Config) {
    let idle_timeout = config.http_rate_limit_window.saturating_mul(2);
    limits.retain(|_, entry| {
        entry.streamers != 0
            || entry.listeners != 0
            || now.duration_since(entry.last_seen) < idle_timeout
    });
}

pub(crate) struct StreamerIpGuard {
    state: Arc<AppState>,
    ip: IpAddr,
}

impl Drop for StreamerIpGuard {
    fn drop(&mut self) {
        let mut limits = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = limits.get_mut(&self.ip) {
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
        let mut limits = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = limits.get_mut(&self.ip) {
            entry.listeners = entry.listeners.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}
