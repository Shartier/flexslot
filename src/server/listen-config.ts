// Local connected use stays on loopback. External listeners are exclusively for the public mock demo.
export function listenConfig(env: Readonly<Record<string, string | undefined>>, publicOrigin: string | null) {
  const host = env.FLEXSLOT_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('FLEXSLOT_HOST must be 127.0.0.1 or 0.0.0.0');
  if (host === '0.0.0.0' && (!publicOrigin || !env.FLEXSLOT_DATA_DIR?.trim())) {
    throw new Error('External listening requires FLEXSLOT_PUBLIC_ORIGIN and a dedicated FLEXSLOT_DATA_DIR');
  }
  const value = env.FLEXSLOT_PORT ?? (publicOrigin ? env.PORT : undefined) ?? '8787';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid HTTP port');
  return { host, port: Number(value) };
}
