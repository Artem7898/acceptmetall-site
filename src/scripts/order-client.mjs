export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

export function resolveOrderEndpoint(value) {
  if (!value) return '/api/orders';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_ORDER_API_URL must be an HTTPS endpoint without credentials, query or fragment');
  }
  return url.href;
}

export class OrderError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function validateAttachment(data) {
  const file = data.get('file');
  if (!file || typeof file === 'string') return;
  if (!file.name && file.size === 0) {
    data.delete('file');
    return;
  }
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name) || file.size === 0) throw new OrderError('invalid_file');
  if (file.size > MAX_ATTACHMENT_SIZE) throw new OrderError('file_too_large');
}

async function fingerprint(data) {
  const entries = [];
  for (const [name, value] of data.entries()) {
    if (typeof value === 'string') entries.push([name, value]);
    else {
      const bytes = await crypto.subtle.digest('SHA-256', await value.arrayBuffer());
      const digest = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
      entries.push([name, value.name, value.type, value.size, digest]);
    }
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

export function createOrderClient({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  let previousFingerprint;
  let requestKey;
  let pending = false;
  return {
    async submit(data) {
      if (pending) throw new OrderError('busy');
      pending = true;
      let timer;
      try {
        validateAttachment(data);
        const current = await fingerprint(data);
        if (current !== previousFingerprint) {
          requestKey = crypto.randomUUID();
          previousFingerprint = current;
        }
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          body: data,
          headers: { 'Idempotency-Key': requestKey, Accept: 'application/json' },
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (response.status !== 200 && response.status !== 201) {
          throw new OrderError('rejected', response.status);
        }
        const result = await response.json();
        if (result?.status !== 'received' || typeof result.orderId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.orderId)) {
          throw new OrderError('invalid_response');
        }
        return result.orderId;
      } catch (error) {
        if (error instanceof OrderError) throw error;
        throw new OrderError(error?.name === 'AbortError' ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
        pending = false;
      }
    },
  };
}
