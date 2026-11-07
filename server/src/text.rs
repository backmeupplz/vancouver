//! Display names and chat text: plain text only, no invisible or direction-changing characters,
//! no stacks of combining marks, no look-alike staff names, and a small word filter.

/// Characters that are invisible or change how text around them is shown (zero-width, bidi
/// controls and isolates, soft hyphen, word joiners, tag characters, BOM).
fn invisible(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x202A..=0x202E
        | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0E | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0xE0000..=0xE0FFF)
}

/// Combining marks that only decorate the letter before them (the ones "zalgo" text stacks).
fn combining(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x0483..=0x0489 | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// A display name: letters and digits of any script plus space - _ . ', 2 to 20 characters,
/// spaces collapsed. None when nothing usable is left or it poses as staff.
pub fn clean_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    for c in raw.chars() {
        if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '\'') {
            out.push(c);
        } else if c.is_whitespace() && !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
    }
    let out: String = out.trim().chars().take(20).collect::<String>().trim_end().to_string();
    let letters = out.chars().filter(|c| c.is_alphanumeric()).count();
    (letters >= 2 && !reserved(&out)).then_some(out)
}

/// Names that would pass for the site or its staff, also when spelled with look-alike letters.
fn reserved(name: &str) -> bool {
    let folded: String = name.chars().filter_map(|c| fold(c).filter(|c| c.is_ascii_alphanumeric())).collect();
    const WORDS: [&str; 8] = ["admin", "moderator", "system", "official", "staff", "server", "support", "vancouverincode"];
    WORDS.iter().any(|w| folded.contains(w)) || folded == "mod" || folded == "mods"
}

/// Lowercase, with common look-alikes (Cyrillic, Greek, digits used as letters) mapped to Latin.
fn fold(c: char) -> Option<char> {
    let c = c.to_lowercase().next()?;
    Some(match c {
        'а' | 'α' | '@' | '4' => 'a',
        'в' | 'β' => 'b',
        'с' | 'ϲ' => 'c',
        'е' | 'ε' | 'ё' | '3' => 'e',
        'һ' => 'h',
        'і' | 'ι' | 'ı' | '1' | '!' | '|' => 'i',
        'ј' => 'j',
        'к' | 'κ' => 'k',
        'м' => 'm',
        'п' | 'η' => 'n',
        'о' | 'ο' | 'σ' | '0' => 'o',
        'р' | 'ρ' => 'p',
        'ѕ' | '$' | '5' => 's',
        'т' | 'τ' | '7' => 't',
        'у' | 'γ' => 'y',
        'х' | 'χ' => 'x',
        'ν' => 'v',
        _ => c,
    })
}

/// Chat text: one line, at most `max` characters, no control or invisible characters, at most two
/// combining marks in a row, and filtered words masked. None when empty.
pub fn clean_text(raw: &str, max: usize) -> Option<String> {
    let mut out = String::new();
    let (mut marks, mut n) = (0, 0);
    for c in raw.chars() {
        if n >= max {
            break;
        }
        if c.is_whitespace() || c.is_control() {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
                n += 1;
            }
            marks = 0;
            continue;
        }
        if invisible(c) {
            continue;
        }
        if combining(c) {
            marks += 1;
            if marks > 2 {
                continue;
            }
        } else {
            marks = 0;
        }
        out.push(c);
        n += 1;
    }
    let out = out.trim_end();
    (!out.is_empty()).then(|| mask(out))
}

// ponytail: a tiny word list matched per word (so "Scunthorpe" stays); a real moderation service
// or a longer list when people actually abuse the chat.
const FILTERED: [&str; 10] = ["nigger", "nigga", "faggot", "fag", "kike", "chink", "spic", "tranny", "wetback", "gook"];

/// Run-length form of a word: (letter, how many times in a row).
fn runs(word: impl Iterator<Item = char>) -> Vec<(char, usize)> {
    let mut r: Vec<(char, usize)> = vec![];
    for c in word {
        match r.last_mut() {
            Some((l, n)) if *l == c => *n += 1,
            _ => r.push((c, 1)),
        }
    }
    r
}

/// Whether a word is a filtered one, after folding look-alikes; stretched letters ("niiice") still
/// count, but "Niger" or "con" are not the words with doubled letters.
fn filtered(word: &str) -> bool {
    let w = runs(word.chars().filter_map(fold));
    FILTERED.iter().any(|f| {
        let f = runs(f.chars());
        let plural = w.len() == f.len() + 1 && w.last().is_some_and(|l| l.0 == 's');
        (w.len() == f.len() || plural) && f.iter().zip(&w).all(|(a, b)| a.0 == b.0 && b.1 >= a.1)
    })
}

/// Masks filtered words with asterisks.
fn mask(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if filtered(word) {
            out.extend(word.chars().map(|_| '*'));
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in text.chars() {
        if c.is_alphanumeric() || matches!(c, '@' | '$') {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// A colour as #rrggbb, lowercased; None otherwise.
pub fn clean_colour(raw: &str) -> Option<String> {
    let hex = raw.strip_prefix('#')?;
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(clean_name("  Harbour   Seal  ").as_deref(), Some("Harbour Seal"));
        assert_eq!(clean_name("Zo\u{200B}e\u{202E}").as_deref(), Some("Zoe"));
        assert_eq!(clean_name("Пётр").as_deref(), Some("Пётр"));
        assert_eq!(clean_name("小明").as_deref(), Some("小明"));
        assert_eq!(clean_name("a\u{0301}\u{0301}\u{0301}b").as_deref(), Some("ab")); // zalgo marks dropped
        assert_eq!(clean_name("<b>x</b>").as_deref(), Some("bxb"));
        assert_eq!(clean_name("x"), None);
        assert_eq!(clean_name("\u{200B}\u{200B}"), None);
        assert_eq!(clean_name("abcdefghijklmnopqrstuvwxyz").map(|s| s.chars().count()), Some(20));
        for staff in ["Admin", "аdmin", "ADM1N", "The Moderator", "mod", "Server bot"] {
            assert_eq!(clean_name(staff), None, "{staff}");
        }
    }

    #[test]
    fn text() {
        assert_eq!(clean_text("  hi\n\tthere  ", 200).as_deref(), Some("hi there"));
        assert_eq!(clean_text("<script>alert(1)</script>", 200).as_deref(), Some("<script>alert(1)</script>")); // plain text, the client never renders HTML
        assert_eq!(clean_text("a\u{200B}b\u{202E}c\u{0007}", 200).as_deref(), Some("abc"));
        assert_eq!(clean_text("e\u{0301}\u{0301}\u{0301}\u{0301}", 200).as_deref(), Some("e\u{0301}\u{0301}"));
        assert_eq!(clean_text("   ", 200), None);
        assert_eq!(clean_text(&"x".repeat(500), 200).map(|s| s.len()), Some(200));
        assert_eq!(clean_text("you f4ggot", 200).as_deref(), Some("you ******"));
        assert_eq!(clean_text("Scunthorpe and Spice in Niger, a con", 200).as_deref(), Some("Scunthorpe and Spice in Niger, a con"));
        assert_eq!(clean_text("FAAAGGOTS!", 200).as_deref(), Some("*********!"));
    }

    #[test]
    fn colours() {
        assert_eq!(clean_colour("#A0b1C2").as_deref(), Some("#a0b1c2"));
        assert_eq!(clean_colour("red"), None);
        assert_eq!(clean_colour("#12345"), None);
        assert_eq!(clean_colour("#1234567"), None);
    }
}
