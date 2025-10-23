/**
 * A regex that matches every ASCII character that can be mapped to the Unicode tags block.
 */
// eslint-disable-next-line no-control-regex
export const TAGHIDABLE_REGEX = /[\u{01}\u{20}-\u{7f}]/u

/**
 * A regex that matches every character in the Unicode tags block.
 */
export const TAG_BLOCK_REGEX = /[\u{e0001}\u{e0020}-\u{e007f}]/u

/**
 * "Hides" the given plaintext using the "Tags" Unicode block.
 *
 * @param plaintext - The printable ASCII input string.
 *                    All characters must be either `0x01`
 *                    or in the range `[0x20, 0x7f]` inclusive.
 * @see https://en.wikipedia.org/wiki/Tags_(Unicode_block)
 */
export function taghide(plaintext: string): string {
  const plaintextUtf8 = [...plaintext].map(char => char.codePointAt(0)!)
  const output: string[] = []
  for (const char of plaintextUtf8) {
    if (char == 0x01 || (char >= 0x20 && char <= 0x7f)) {
      output.push(String.fromCodePoint(0xe0000 | char))
    } else {
      throw "could not taghide non-ascii input"
    }
  }
  return output.join("")
}

/**
 * "Reveals" the given taghidden ciphertext.
 *
 * @param ciphertext - The ciphertext.
 */
export function untaghide(ciphertext: string): string {
  const ciphertextUtf8 = [...ciphertext].map(char => char.codePointAt(0)!)
  const output: string[] = []
  for (const char of ciphertextUtf8) {
    if (char == 0xe0001 || (char >= 0xe0020 && char <= 0xe007f)) {
      output.push(String.fromCodePoint(0x7f & char))
    } else {
      throw "could not untaghide non-tags block input"
    }
  }
  return output.join("")
}
