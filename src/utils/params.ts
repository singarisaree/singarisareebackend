export function paramId(params: { id?: string | string[] }): string {
  const id = params.id;
  if (Array.isArray(id)) return id[0];
  return id || '';
}

export function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}
