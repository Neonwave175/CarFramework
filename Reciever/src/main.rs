use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
    env,
    io::{BufRead, BufReader, Write},
    net::UdpSocket,
    process::{Child, Command, Stdio},
};

fn event(kind: &str, message: &str) {
    println!("{}", json!({"type": kind, "message": message}));
}

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 6 {
        return Err("Expected Python executable, worker path, framework directory, sender public key, and receiver private key".into());
    }
    let socket = UdpSocket::bind("0.0.0.0:5005")
        .map_err(|e| format!("Cannot listen on UDP port 5005: {e}"))?;
    let mut worker = Worker(
        Command::new(&args[1])
            .args(["-u", &args[2], &args[3], &args[4], &args[5]])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Could not start Python crypto worker: {e}"))?,
    );
    let mut input = worker.0.stdin.take().ok_or("Worker input unavailable")?;
    let mut output = BufReader::new(worker.0.stdout.take().ok_or("Worker output unavailable")?);
    event(
        "status",
        "Waiting for authenticated key exchange on UDP port 5006…",
    );
    let mut line = String::new();
    output.read_line(&mut line).map_err(|e| e.to_string())?;
    if line.trim() != "READY" {
        return Err(format!("Key exchange failed: {}", line.trim()));
    }
    event("status", "Connected. Waiting for video frames…");
    let mut data = [0u8; 65535];
    loop {
        let (size, _) = socket
            .recv_from(&mut data)
            .map_err(|e| format!("Video socket error: {e}"))?;
        writeln!(input, "{}", STANDARD.encode(&data[..size]))
            .map_err(|e| format!("Crypto worker input: {e}"))?;
        input.flush().map_err(|e| e.to_string())?;
        line.clear();
        if output.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("Crypto worker stopped unexpectedly".into());
        }
        if let Some(frame) = line.trim().strip_prefix("FRAME ") {
            println!("{}", json!({"type":"frame", "data":frame}));
        } else {
            event(
                "frame_error",
                line.trim()
                    .strip_prefix("ERROR ")
                    .unwrap_or("Frame could not be decrypted"),
            );
        }
    }
}
fn main() {
    if let Err(e) = run() {
        event("error", &e);
        std::process::exit(1);
    }
}
