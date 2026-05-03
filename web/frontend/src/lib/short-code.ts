const WORD_COUNT = 3
const INITIALS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v']
const VOWELS = ['a', 'e', 'i', 'o']
const ENDINGS = ['dar', 'len', 'mor', 'tun']

function randomInt(maxExclusive: number) {
  const values = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
  do {
    window.crypto.getRandomValues(values)
  } while (values[0] >= limit)
  return values[0] % maxExclusive
}

function encodeWord(index: number) {
  const initial = INITIALS[(index >> 4) & 0x0f]
  const vowel = VOWELS[(index >> 2) & 0x03]
  const ending = ENDINGS[index & 0x03]
  return `${initial}${vowel}${ending}`
}

function decodeWord(word: string) {
  if (word.length < 3) return null
  const initial = INITIALS.indexOf(word.charAt(0))
  const vowel = VOWELS.indexOf(word.charAt(1))
  const ending = ENDINGS.indexOf(word.slice(2))
  if (initial < 0 || vowel < 0 || ending < 0) return null
  return (initial << 4) | (vowel << 2) | ending
}

function tokenize(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export function generate_short_code() {
  const slot = 100 + randomInt(9900)
  const words = Array.from({ length: WORD_COUNT }, () => encodeWord(randomInt(256)))
  return `${slot}-${words.join('-')}`
}

export function normalize_short_code(value: string) {
  const tokens = tokenize(value)
  if (tokens.length !== WORD_COUNT + 1) throw new Error('short code must have one slot and exactly three words')

  const slotToken = tokens[0] ?? ''
  if (!/^\d+$/.test(slotToken)) throw new Error('slot must be a decimal number')
  const slot = Number(slotToken)
  if (!Number.isInteger(slot) || slot < 0 || slot > 65535) throw new Error('slot must fit in u16')

  const words = tokens.slice(1).map((word) => {
    const decoded = decodeWord(word)
    if (decoded === null) throw new Error(`invalid code word '${word}'`)
    return encodeWord(decoded)
  })

  return `${slot}-${words.join('-')}`
}
