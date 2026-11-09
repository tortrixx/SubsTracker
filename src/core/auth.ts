/** JWT 载荷：用户名 + 过期时间（秒级 Unix 时间戳），其余字段透传。 */
export interface JwtPayload {
  username: string;
  exp?: number;
  [key: string]: unknown;
}

const CryptoJS = {
  HmacSHA256: function (message: string, key: string): Promise<string> {
    const keyData = new TextEncoder().encode(key);
    const messageData = new TextEncoder().encode(message);

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

  const base64Header = btoa(JSON.stringify(header));
  const base64Payload = btoa(JSON.stringify(payload));
  const signatureInput = base64Header + '.' + base64Payload;
  const signature = await CryptoJS.HmacSHA256(signatureInput, secret);

  return signatureInput + '.' + signature;
}

async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    if (!token || !secret) {
      console.log('[JWT] Token或Secret为空');
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      console.log('[JWT] Token格式错误，部分数量:', parts.length);
      return null;
    }

    const [headerBase64, payloadBase64, signature] = parts;
    const signatureInput = headerBase64 + '.' + payloadBase64;
    const expectedSignature = await CryptoJS.HmacSHA256(signatureInput, secret);

    if (signature !== expectedSignature) {
      console.log('[JWT] 签名验证失败');
      return null;
    }

    const payload = JSON.parse(atob(payloadBase64)) as JwtPayload;
    // 必须校验 exp，否则过期 token 仍可长期使用
    if (payload.exp != null) {
      const exp = Number(payload.exp);
      if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
        console.log('[JWT] Token 已过期');
        return null;
      }
    }
    console.log('[JWT] 验证成功，用户:', payload.username);
    return payload;
  } catch (error) {
    console.error('[JWT] 验证过程出错:', error);
    return null;
  }
}

export { generateJWT, verifyJWT };
