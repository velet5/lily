//! Export MIDI (DECISIONS D54): the music the transport plays, written where
//! the user chooses in a save panel, whose checkbox leaves out the tracks of
//! the parts muted in the Parts fold (D45). Only whole tracks are left out:
//! the bytes of the others are lilypond's, unchanged.
use std::path::Path;

/// The checkbox names the muted parts while there are at most this many.
const NAMED_PARTS: usize = 3;

/// The tracks of a Standard MIDI File, as midi.js indexes them: its `MTrk`
/// chunks in order. `bytes` without the tracks at `tracks`, and the header's
/// track count with them; any other chunk is kept.
pub fn without_tracks(bytes: &[u8], tracks: &[usize]) -> Result<Vec<u8>, String> {
    let invalid = |why: &str| format!("The MIDI could not be exported: {why}.");
    if bytes.len() < 14 || &bytes[0..4] != b"MThd" {
        return Err(invalid("it is not a MIDI file"));
    }
    let header_end = 8 + chunk_length(bytes, 0) as usize;
    if header_end < 14 || header_end > bytes.len() {
        return Err(invalid("its header is cut short"));
    }
    let mut out = bytes[..header_end].to_vec();
    let mut at = header_end;
    let mut track = 0;
    let mut kept = 0u16;
    while at < bytes.len() {
        if at + 8 > bytes.len() {
            return Err(invalid("it ends inside a chunk"));
        }
        let end = at + 8 + chunk_length(bytes, at) as usize;
        if end > bytes.len() {
            return Err(invalid("a chunk runs past its end"));
        }
        if &bytes[at..at + 4] == b"MTrk" {
            let leave_out = tracks.contains(&track);
            track += 1;
            if leave_out {
                at = end;
                continue;
            }
            kept += 1;
        }
        out.extend_from_slice(&bytes[at..end]);
        at = end;
    }
    if kept == 0 {
        return Err(invalid("it would have no tracks left"));
    }
    out[10..12].copy_from_slice(&kept.to_be_bytes());
    Ok(out)
}

fn chunk_length(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
}

/// The save panel's checkbox: "Leave out the muted part Tenor", or the parts
/// counted when there are more than a few.
pub fn checkbox_title(names: &[String]) -> String {
    match names {
        [name] => format!("Leave out the muted part {name}"),
        _ if names.len() <= NAMED_PARTS => {
            let (last, first) = names.split_last().expect("more than one name");
            format!("Leave out the muted parts {} and {last}", first.join(", "))
        }
        _ => format!("Leave out the {} muted parts", names.len()),
    }
}

/// The file the panel suggests: the score's name with `.mid`, beside it.
pub fn suggested_name(root_file: &Path) -> String {
    let stem = root_file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "score".into());
    format!("{stem}.mid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = tag.to_vec();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(data);
        chunk
    }

    /// Format 1, `tracks` tracks of one byte each, which is their index; an unknown chunk after the first.
    fn midi(tracks: u8) -> Vec<u8> {
        let mut bytes = chunk(b"MThd", &[0, 1, 0, tracks, 1, 0x80]);
        for track in 0..tracks {
            bytes.extend(chunk(b"MTrk", &[track]));
            if track == 0 {
                bytes.extend(chunk(b"XFIH", &[9, 9]));
            }
        }
        bytes
    }

    #[test]
    fn leaves_out_the_tracks_and_counts_the_rest() {
        let out = without_tracks(&midi(4), &[1, 3]).unwrap();
        let mut expected = chunk(b"MThd", &[0, 1, 0, 2, 1, 0x80]);
        expected.extend(chunk(b"MTrk", &[0]));
        expected.extend(chunk(b"XFIH", &[9, 9]));
        expected.extend(chunk(b"MTrk", &[2]));
        assert_eq!(out, expected);
    }

    #[test]
    fn no_tracks_to_leave_out_is_the_same_file() {
        assert_eq!(without_tracks(&midi(3), &[]).unwrap(), midi(3));
        // A track the file does not have changes nothing.
        assert_eq!(without_tracks(&midi(3), &[7]).unwrap(), midi(3));
    }

    #[test]
    fn a_real_compile_keeps_its_bytes() {
        // lilypond's: a control track and three staves, at 14, 99, 288 and 448.
        let bytes = include_bytes!("../../../vscode/test/fixtures/sample.midi");
        let out = without_tracks(bytes, &[2]).unwrap();
        assert_eq!(&out[10..12], &[0, 3]);
        assert_eq!(&out[12..288], &bytes[12..288]);
        assert_eq!(&out[288..], &bytes[448..]);
        assert_eq!(parse_tracks(&out), 3);
    }

    fn parse_tracks(bytes: &[u8]) -> usize {
        let mut at = 14;
        let mut tracks = 0;
        while at < bytes.len() {
            assert_eq!(&bytes[at..at + 4], b"MTrk");
            at += 8 + chunk_length(bytes, at) as usize;
            tracks += 1;
        }
        assert_eq!(at, bytes.len());
        tracks
    }

    #[test]
    fn refuses_what_is_not_midi() {
        assert!(without_tracks(b"RIFF....WAVEfmt ", &[]).is_err());
        let mut cut = midi(2);
        cut.truncate(cut.len() - 1);
        assert!(without_tracks(&cut, &[]).is_err());
        assert!(without_tracks(&midi(1), &[0]).is_err());
    }

    #[test]
    fn names_the_muted_parts() {
        let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        assert_eq!(
            checkbox_title(&names(&["Tenor"])),
            "Leave out the muted part Tenor"
        );
        assert_eq!(
            checkbox_title(&names(&["S.A", "Tenor", "Piano · F clef"])),
            "Leave out the muted parts S.A, Tenor and Piano · F clef"
        );
        assert_eq!(
            checkbox_title(&names(&["a", "b", "c", "d"])),
            "Leave out the 4 muted parts"
        );
    }

    #[test]
    fn suggests_the_score_name() {
        assert_eq!(suggested_name(Path::new("/music/ode.ly")), "ode.mid");
    }
}
