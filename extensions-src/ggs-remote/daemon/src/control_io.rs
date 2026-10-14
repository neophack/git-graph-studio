//! The control channel's framed read (the transport half): one length-prefixed body.
//! The message TYPES live in the shared ggs-remote-proto crate; this is the daemon's
//! async I/O over its pipe/socket.

/// Read one length-prefixed message body.
pub async fn read_message<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len > ggs_remote_proto::MAX_CONTROL_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("control message too large: {len}"),
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    Ok(body)
}
