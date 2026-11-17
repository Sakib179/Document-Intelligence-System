export function evidenceLocation(value: unknown): {
  page?: number;
  worksheet?: string;
  cell?: string;
  text?: string;
} {
  let remaining = 100;
  function find(value: unknown, depth: number): {
    page?: number;
    worksheet?: string;
    cell?: string;
    text?: string;
  } | null {
    if (!value || typeof value !== 'object' || depth > 5 || --remaining < 0)
      return null;
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' && (typeof record.page === 'number' || typeof record.worksheet === 'string'))
      return { ...(typeof record.page === 'number' && Number.isInteger(record.page) && record.page > 0 ? { page: record.page } : {}), ...(typeof record.worksheet === 'string' ? { worksheet: record.worksheet } : {}), ...(typeof record.cell === 'string' ? { cell: record.cell } : {}), text: record.text };
    for (const item of Object.values(record)) {
      const found = find(item, depth + 1);
      if (found)
        return found;
    }
    return null;
  }
  return find(value, 0) ?? {};
}
