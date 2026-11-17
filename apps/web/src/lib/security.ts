const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export function allowedProxyPath(path: string, method: string) {
  if (/[\\%?#]|\.\.|\/\//.test(path))
    return false;
  const reads = [/^(me|dashboard|search|reviews|workspace\/(documents|reconciliations))$/, new RegExp('^documents(?:/' + uuid + '(?:/(status|result|extractions|understanding|index|preview|content|pages(?:/[1-9][0-9]*)?))?)?$'), new RegExp('^invoices/' + uuid + '/(history|validations)$'), new RegExp('^(upload-batches|reconciliations)/' + uuid + '$')];
  if (method === 'GET')
    return reads.some(pattern => pattern.test(path));
  if (method === 'POST')
    return path === 'documents' || path === 'reconciliations' || new RegExp('^jobs/' + uuid + '/retry$').test(path) || new RegExp('^(documents/' + uuid + '/(index|extractions)|invoices/' + uuid + '/validations)$').test(path);
  if (method === 'DELETE')
    return new RegExp('^documents/' + uuid + '$').test(path);
  return method === 'PATCH' && (new RegExp('^invoices/' + uuid + '(?:/financial-terms)?$').test(path) || new RegExp('^documents/' + uuid + '/privacy$').test(path));
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  // Next.js can reconstruct request.url with its internal listening hostname.
  // Host retains the address used by the browser; forwarded headers are not trusted.
  const expectedOrigin = url.protocol + '//' + (request.headers.get('host') ?? url.host);
  return origin === expectedOrigin && !['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? '');
}
