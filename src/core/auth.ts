/** JWT 载荷：用户名 + 过期时间（秒级 Unix 时间戳），其余字段透传。 */
export interface JwtPayload {
  username: string;
  exp?: number;
  [key: string]: unknown;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** UTF-8 安全的 Base64 编码，避免非 Latin1 用户名在 btoa 时抛异常。 */
function encodeBase64Utf8(input: string): string {
  const bytes = textEncoder.encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** UTF-8 安全的 Base64 解码（同时兼容 standard 与 base64url）。 */
function decodeBase64Utf8(b64: string): string {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return textDecoder.decode(bytes);
}

/** 常量时间字符串比较，降低签名/密钥/密码校验的时序侧信道风险。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(String(a ?? ''));
  const bBytes = textEncoder.encode(String(b ?? ''));
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

const CryptoJS = {
  HmacSHA256: function (message: string, key: string): Promise<string> {
    const keyData = textEncoder.encode(key);
    const messageData = textEncoder.encode(message);

    return Promise.resolve().then(() => {
      return crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: {name: "SHA-256"} },
        false,
        ["sign"]
      );
    }).then(cryptoKey => {
      return crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        messageData
      );
    }).then(buffer => {
      const hashArray = Array.from(new Uint8Array(buffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    });
  }
};

async function generateJWT(username: string, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { username, exp: Math.floor(Date.now() / 1000) + 86400 };

  const base64Header = encodeBase64Utf8(JSON.stringify(header));
  const base64Payload = encodeBase64Utf8(JSON.stringify(payload));
  const signatureInput = base64Header + '.' + base64Payload;
  const signature = await CryptoJS.HmacSHA256(signatureInput, secret);

  return signatureInput + '.' + signature;
}

async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    if (!token || !secret) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerBase64, payloadBase64, signature] = parts;
    const signatureInput = headerBase64 + '.' + payloadBase64;
    const expectedSignature = await CryptoJS.HmacSHA256(signatureInput, secret);

    if (!timingSafeEqual(signature, expectedSignature)) {
      return null;
    }

    const parsed: unknown = JSON.parse(decodeBase64Utf8(payloadBase64));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const payload = parsed as JwtPayload;
    // 必须校验 exp，否则过期 token 仍可长期使用
    if (payload.exp != null) {
      const exp = Number(payload.exp);
      if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
    }
    return payload;
  } catch (error) {
    console.error('[JWT] 验证过程出错:', error);
    return null;
  }
}

export { generateJWT, verifyJWT };
