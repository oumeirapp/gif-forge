use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

use gif::{ColorOutput, DecodeOptions, Decoder, Repeat};
use gif_dispose::Screen;
use gifski::{progress::NoProgress, Collector, Settings};
use serde::{Deserialize, Serialize};

const VERSION: &str = env!("CARGO_PKG_VERSION");

type WorkerError = Box<dyn Error + Send + Sync>;
type WorkerResult<T> = Result<T, WorkerError>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodeRequest {
    input_path: PathBuf,
    output_path: PathBuf,
    quality: u8,
    loop_count: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncodeResult {
    quality: u8,
    frames: usize,
}

fn validate_request(request: &EncodeRequest) -> WorkerResult<()> {
    if !(1..=100).contains(&request.quality) {
        return Err("quality must be an integer from 1 through 100".into());
    }
    if request.input_path == request.output_path {
        return Err("inputPath and outputPath must be different".into());
    }
    if !request.input_path.is_file() {
        return Err(format!("input GIF does not exist: {}", request.input_path.display()).into());
    }
    if request.output_path.exists() {
        return Err(format!(
            "output path already exists: {}",
            request.output_path.display()
        )
        .into());
    }
    Ok(())
}

fn repeat_from_loop_count(loop_count: Option<u16>) -> Repeat {
    match loop_count {
        None => Repeat::Finite(0),
        Some(0) => Repeat::Infinite,
        Some(count) => Repeat::Finite(count),
    }
}

fn open_decoder(path: &Path) -> WorkerResult<Decoder<BufReader<File>>> {
    let input = BufReader::new(File::open(path)?);
    let mut options = DecodeOptions::new();
    options.set_color_output(ColorOutput::Indexed);
    Ok(options.read_info(input)?)
}

fn collect_frames(
    mut decoder: Decoder<BufReader<File>>,
    mut screen: Screen,
    collector: Collector,
) -> WorkerResult<usize> {
    let mut frame_index = 0usize;
    let mut elapsed_centiseconds = 0u64;

    while let Some(frame) = decoder.read_next_frame()? {
        screen.blit_frame(frame)?;
        let pixels = screen.pixels_rgba().map_buf(|buffer| buffer.to_owned());
        let presentation_timestamp = elapsed_centiseconds as f64 / 100.0;

        collector.add_frame_rgba(frame_index, pixels, presentation_timestamp)?;
        elapsed_centiseconds += u64::from(frame.delay.max(1));
        frame_index += 1;
    }

    if frame_index == 0 {
        return Err("input GIF contains no frames".into());
    }

    Ok(frame_index)
}

fn encode(request: &EncodeRequest) -> WorkerResult<EncodeResult> {
    validate_request(request)?;

    let decoder = open_decoder(&request.input_path)?;
    let width = u32::from(decoder.width());
    let height = u32::from(decoder.height());
    let screen = Screen::new_decoder(&decoder);
    let settings = Settings {
        width: Some(width),
        height: Some(height),
        quality: 100,
        fast: false,
        repeat: repeat_from_loop_count(request.loop_count),
    };
    let (collector, mut writer) = gifski::new(settings)?;

    // Gifski exposes this focused compression control as a deprecated method.
    // Pinning the crate keeps the behavior stable while leaving palette and
    // motion quality at 100 so the user's upstream choices are preserved.
    #[allow(deprecated)]
    writer.set_lossy_quality(request.quality);

    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&request.output_path)?;

    let result = std::thread::scope(|scope| -> WorkerResult<usize> {
        let collector_thread = scope.spawn(move || collect_frames(decoder, screen, collector));
        let write_result = writer.write(BufWriter::new(output), &mut NoProgress {});
        let collected_frames = collector_thread
            .join()
            .map_err(|_| "Gifski frame collector panicked")??;
        write_result?;
        Ok(collected_frames)
    });

    match result {
        Ok(frames) => Ok(EncodeResult {
            quality: request.quality,
            frames,
        }),
        Err(error) => {
            let _ = fs::remove_file(&request.output_path);
            Err(error)
        }
    }
}

fn parse_request(value: &str) -> WorkerResult<EncodeRequest> {
    Ok(serde_json::from_str(value)?)
}

fn run() -> WorkerResult<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();

    if arguments.as_slice() == ["--version"] {
        println!("gifski-worker {VERSION}");
        return Ok(());
    }

    if arguments.len() != 2 || arguments[0] != "encode" {
        return Err("usage: gifski-worker encode '<JSON>'".into());
    }

    let request = parse_request(&arguments[1])?;
    let result = encode(&request)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_counts_map_to_gif_repeat_values() {
        assert_eq!(repeat_from_loop_count(None), Repeat::Finite(0));
        assert_eq!(repeat_from_loop_count(Some(0)), Repeat::Infinite);
        assert_eq!(repeat_from_loop_count(Some(3)), Repeat::Finite(3));
    }

    #[test]
    fn quality_must_be_between_one_and_one_hundred() {
        let missing = PathBuf::from("/definitely/missing/input.gif");
        let output = PathBuf::from("/definitely/missing/output.gif");

        let too_low = EncodeRequest {
            input_path: missing.clone(),
            output_path: output.clone(),
            quality: 0,
            loop_count: None,
        };
        let too_high = EncodeRequest {
            input_path: missing,
            output_path: output,
            quality: 101,
            loop_count: None,
        };

        assert!(validate_request(&too_low)
            .unwrap_err()
            .to_string()
            .contains("1 through 100"));
        assert!(validate_request(&too_high)
            .unwrap_err()
            .to_string()
            .contains("1 through 100"));
    }
}
