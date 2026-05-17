use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::SinkExt;
use tokio::net::TcpStream;
use tokio::time;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

/// Shared control-plane WebSocket connect timeout.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Shared control-plane WebSocket frame write timeout.
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn build_hub_url(host: &str, port: u16, tls: bool) -> String {
    let scheme = if tls { "wss" } else { "ws" };
    format!("{}://{}:{}", scheme, host, port)
}

pub(crate) async fn connect(
    url: &str,
    connection_label: &str,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let (ws_stream, _) = time::timeout(CONNECT_TIMEOUT, connect_async(url))
        .await
        .with_context(|| format!("{} timed out after {:?}", connection_label, CONNECT_TIMEOUT))?
        .with_context(|| format!("{} failed", connection_label))?;
    Ok(ws_stream)
}

pub(crate) async fn send_with_timeout<S>(
    sink: &mut S,
    msg: Message,
    connection_label: &str,
) -> Result<()>
where
    S: SinkExt<Message, Error = tungstenite::Error> + Unpin,
{
    send_with_timeout_inner(sink, msg, connection_label, WRITE_TIMEOUT).await
}

async fn send_with_timeout_inner<S>(
    sink: &mut S,
    msg: Message,
    connection_label: &str,
    write_timeout: Duration,
) -> Result<()>
where
    S: SinkExt<Message, Error = tungstenite::Error> + Unpin,
{
    match time::timeout(write_timeout, sink.send(msg)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(anyhow::anyhow!("{} write error: {}", connection_label, e)),
        Err(_) => Err(anyhow::anyhow!(
            "{} write timeout after {:?}",
            connection_label,
            write_timeout
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_util::Sink;

    use super::*;

    struct PendingSink;

    impl Sink<Message> for PendingSink {
        type Error = tungstenite::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Pending
        }

        fn start_send(
            self: Pin<&mut Self>,
            _item: Message,
        ) -> std::result::Result<(), Self::Error> {
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn send_with_timeout_rejects_stalled_sink() {
        let mut sink = PendingSink;
        let err = send_with_timeout_inner(
            &mut sink,
            Message::Binary(vec![1_u8, 2, 3].into()),
            "test control ws",
            Duration::from_millis(20),
        )
        .await
        .expect_err("stalled control writer must time out");

        assert!(
            err.to_string().contains("write timeout"),
            "unexpected error: {err:#}"
        );
    }
}
