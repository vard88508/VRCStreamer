use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;

use super::{AAC_MAX_ACCESS_UNIT_BYTES, Config, H264_MAX_NAL_UNITS, MEDIA_FRAME_HEADER_BYTES};

const H264_MAX_PARAMETER_SET_BYTES: usize = 1024;

pub(crate) enum StreamerMediaFrame {
    Audio {
        access_unit: Bytes,
        rtp_timestamp: u32,
    },
    Video {
        access_unit: Bytes,
        keyframe: bool,
        rtp_timestamp: u32,
    },
}

#[derive(Clone)]
pub(crate) enum AudioMessage {
    Wake,
    Frame {
        access_unit: Bytes,
        rtp_timestamp: u32,
    },
}

#[derive(Clone)]
pub(crate) enum VideoMessage {
    Wake,
    Frame {
        access_unit: Bytes,
        keyframe: bool,
        rtp_timestamp: u32,
    },
}

pub(crate) fn validate_aac_access_unit(access_unit: &[u8]) -> Result<(), &'static str> {
    if access_unit.len() < 4 {
        return Err("aac frame is too small");
    }
    if access_unit.len() > AAC_MAX_ACCESS_UNIT_BYTES {
        return Err("aac frame is too large");
    }
    if looks_like_adts_frame(access_unit) {
        return Err("expected raw AAC access units, got ADTS");
    }
    if let Some(reason) = rejected_media_signature(access_unit) {
        return Err(reason);
    }
    Ok(())
}

pub(crate) fn parse_streamer_media_frame(
    frame: Bytes,
    config: &Config,
) -> Result<StreamerMediaFrame, &'static str> {
    let Some((&kind, _)) = frame.split_first() else {
        return Err("media frame is empty");
    };

    match kind {
        0x00 => {
            if frame.len() < MEDIA_FRAME_HEADER_BYTES {
                return Err("audio frame header is too small");
            }
            let rtp_timestamp = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
            let access_unit = frame.slice(MEDIA_FRAME_HEADER_BYTES..);
            if access_unit.len() > config.max_aac_frame_bytes {
                return Err("aac frame is too large");
            }
            validate_aac_access_unit(&access_unit)?;
            Ok(StreamerMediaFrame::Audio {
                access_unit,
                rtp_timestamp,
            })
        }
        0x01 | 0x02 => {
            if !config.video_enabled {
                return Err("video is disabled on this server");
            }
            if frame.len() < MEDIA_FRAME_HEADER_BYTES {
                return Err("video frame header is too small");
            }
            let keyframe = kind == 0x01;
            let rtp_timestamp = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
            let access_unit = frame.slice(MEDIA_FRAME_HEADER_BYTES..);
            validate_h264_access_unit(&access_unit, keyframe, config.max_h264_frame_bytes)?;
            Ok(StreamerMediaFrame::Video {
                access_unit,
                keyframe,
                rtp_timestamp,
            })
        }
        _ => Err("unknown media frame type"),
    }
}

pub(crate) fn validate_h264_access_unit(
    access_unit: &[u8],
    keyframe: bool,
    max_bytes: usize,
) -> Result<(), &'static str> {
    if access_unit.len() < 5 {
        return Err("h264 access unit is too small");
    }
    if access_unit.len() > max_bytes {
        return Err("h264 access unit is too large");
    }
    if let Some(reason) = rejected_container_signature(access_unit) {
        return Err(reason);
    }

    let mut saw_slice = false;
    let mut saw_idr = false;
    for_each_h264_nal(access_unit, |nal| {
        if nal[0] & 0x80 != 0 {
            return Err("h264 forbidden zero bit is set");
        }
        match nal[0] & 0x1f {
            1 => saw_slice = true,
            5 => {
                saw_slice = true;
                saw_idr = true;
            }
            6..=9 => {}
            _ => return Err("unsupported h264 nal unit"),
        }
        Ok(())
    })?;

    if !saw_slice {
        return Err("h264 access unit has no video slice");
    }
    if keyframe && !saw_idr {
        return Err("h264 keyframe has no idr slice");
    }
    Ok(())
}

pub(crate) fn h264_sdp_fmtp(access_unit: &[u8]) -> Result<String, &'static str> {
    let mut profile = None;
    let mut sps = None;
    let mut pps = None;

    for_each_h264_nal(access_unit, |nal| {
        match nal[0] & 0x1f {
            7 if sps.is_none() => {
                if nal.len() < 4 {
                    return Err("h264 sps is too small");
                }
                if nal.len() > H264_MAX_PARAMETER_SET_BYTES {
                    return Err("h264 sps is too large");
                }
                profile = Some([nal[1], nal[2], nal[3]]);
                sps = Some(STANDARD.encode(nal));
            }
            8 if pps.is_none() => {
                if nal.len() > H264_MAX_PARAMETER_SET_BYTES {
                    return Err("h264 pps is too large");
                }
                pps = Some(STANDARD.encode(nal));
            }
            _ => {}
        }
        Ok(())
    })?;

    let [profile, compatibility, level] = profile.ok_or("h264 access unit has no sps")?;
    let sps = sps.ok_or("h264 access unit has no sps")?;
    let pps = pps.ok_or("h264 access unit has no pps")?;
    Ok(format!(
        "packetization-mode=1; profile-level-id={profile:02x}{compatibility:02x}{level:02x}; sprop-parameter-sets={sps},{pps}"
    ))
}

fn for_each_h264_nal<F>(access_unit: &[u8], mut f: F) -> Result<(), &'static str>
where
    F: FnMut(&[u8]) -> Result<(), &'static str>,
{
    let mut nal_start = start_h264_payload(access_unit)?;
    let mut count = 0usize;

    loop {
        let next = find_h264_start_code(access_unit, nal_start);
        let nal_end = next.map_or(access_unit.len(), |(index, _)| index);
        if nal_end > nal_start {
            count += 1;
            if count > H264_MAX_NAL_UNITS {
                return Err("too many h264 nal units");
            }
            f(&access_unit[nal_start..nal_end])?;
        }

        let Some((start, len)) = next else {
            break;
        };
        nal_start = start + len;
    }

    if count == 0 {
        return Err("h264 access unit has no nal units");
    }
    Ok(())
}

pub(crate) fn start_h264_payload(access_unit: &[u8]) -> Result<usize, &'static str> {
    find_h264_start_code(access_unit, 0)
        .map(|(start, len)| start + len)
        .ok_or("expected annex-b h264 start code")
}

pub(crate) fn find_h264_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                return Some((i, 3));
            }
            if i + 4 <= data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                return Some((i, 4));
            }
        }
        i += 1;
    }
    None
}

fn rejected_media_signature(frame: &[u8]) -> Option<&'static str> {
    if let Some(reason) = rejected_container_signature(frame) {
        return Some(reason);
    }
    if frame.starts_with(&[0x00, 0x00, 0x01]) || frame.starts_with(&[0x00, 0x00, 0x00, 0x01]) {
        return Some("video codecs are not accepted");
    }
    None
}

fn rejected_container_signature(frame: &[u8]) -> Option<&'static str> {
    if frame.starts_with(b"ftyp") || frame.get(4..8) == Some(b"ftyp") {
        return Some("container formats are not accepted");
    }
    if frame.starts_with(b"OggS")
        || frame.starts_with(b"RIFF")
        || frame.starts_with(b"fLaC")
        || frame.starts_with(b"ID3")
        || frame.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
    {
        return Some("container formats are not accepted");
    }
    if frame[0] == 0x47 && frame.len() >= 188 && frame.get(188) == Some(&0x47) {
        return Some("mpeg-ts is not accepted");
    }
    if frame[0] == 0xff && (frame[1] & 0xe0) == 0xe0 {
        return Some("mpeg audio is not accepted");
    }
    None
}

fn looks_like_adts_frame(frame: &[u8]) -> bool {
    if frame.len() < 7 || frame[0] != 0xff || (frame[1] & 0xf0) != 0xf0 {
        return false;
    }

    let protection_absent = (frame[1] & 0x01) != 0;
    let header_len = if protection_absent { 7 } else { 9 };
    let frame_len = (((frame[3] & 0x03) as usize) << 11)
        | ((frame[4] as usize) << 3)
        | (((frame[5] & 0xe0) as usize) >> 5);

    frame_len == frame.len() && frame_len >= header_len
}
