import sodium from 'libsodium-wrappers'

const PREFIX = 'v1.'

export class DecryptError extends Error {
  override name = 'DecryptError'
}

export interface Cipher {
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}

export async function createCipher(key: Uint8Array): Promise<Cipher> {
  await sodium.ready
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(`master key must be ${sodium.crypto_secretbox_KEYBYTES} bytes`)
  }
  const keyCopy = new Uint8Array(key)
  const nonceBytes = sodium.crypto_secretbox_NONCEBYTES
  const variant = sodium.base64_variants.ORIGINAL

  return {
    encrypt(plaintext) {
      const nonce = sodium.randombytes_buf(nonceBytes)
      const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, keyCopy)
      const out = new Uint8Array(nonce.length + box.length)
      out.set(nonce)
      out.set(box, nonce.length)
      return PREFIX + sodium.to_base64(out, variant)
    },
    decrypt(ciphertext) {
      if (!ciphertext.startsWith(PREFIX)) throw new DecryptError('unknown ciphertext format')
      let bytes: Uint8Array
      try {
        bytes = sodium.from_base64(ciphertext.slice(PREFIX.length), variant)
      } catch {
        throw new DecryptError('ciphertext is not valid base64')
      }
      if (bytes.length < nonceBytes + sodium.crypto_secretbox_MACBYTES) throw new DecryptError('ciphertext too short')
      try {
        const plain = sodium.crypto_secretbox_open_easy(bytes.subarray(nonceBytes), bytes.subarray(0, nonceBytes), keyCopy)
        return sodium.to_string(plain)
      } catch {
        throw new DecryptError('decryption failed')
      }
    },
  }
}
