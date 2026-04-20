import { customAlphabet } from 'nanoid'

export const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const DEFAULT_ID_LENGTH = 12

export function generateId(length: number = DEFAULT_ID_LENGTH): string {
  return customAlphabet(ID_ALPHABET, length)()
}
