export function formatBaseUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const digits = magnitude.toString().padStart(decimals + 1, '0');
  const integer = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fractional = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fractional ? `.${fractional}` : ''}`;
}

export function formatHumanAmount(value: string): string {
  const [integer, fractional] = value.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractional ? `${grouped}.${fractional}` : grouped;
}

export function shortAddress(value: string, head = 7, tail = 5): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function errorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  let current = error;

  for (let depth = 0; current != null && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') {
      messages.push(String(current));
      break;
    }
    const item = current as { message?: unknown; reason?: unknown; code?: unknown; cause?: unknown };
    if (typeof item.message === 'string' && item.message && item.message !== 'Error') messages.push(item.message);
    if (typeof item.reason === 'string' && item.reason) messages.push(item.reason);
    if (typeof item.code === 'string' && item.code) messages.push(`code=${item.code}`);
    current = item.cause;
  }

  return [...new Set(messages)].join(' · ') || 'Unknown error';
}

export function isUserCancellation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  for (let depth = 0; current != null && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    const item = current as { message?: unknown; reason?: unknown; code?: unknown; cause?: unknown };
    const code = String(item.code ?? '').toUpperCase();
    if (['4001', 'ACTION_REJECTED', 'USER_REJECTED', 'USER_CANCELLED', 'USER_CANCELED'].includes(code)) {
      return true;
    }
    const detail = [item.message, item.reason]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
    if (/\buser (?:rejected|declined|cancelled|canceled|denied|aborted)\b|\b(?:rejected|declined|cancelled|canceled|denied) by (?:the )?user\b/i.test(detail)) {
      return true;
    }
    current = item.cause;
  }
  return false;
}
