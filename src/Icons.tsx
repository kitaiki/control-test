export function Icon({ name, size = 18 }: { name: 'building' | 'layers' | 'pin' | 'focus' | 'close' | 'arrow' | 'clock' | 'grid'; size?: number }) {
  const paths = {
    building: 'M5 21V4l10-2v19M15 9h4v12M3 21h18M8 7h3M8 11h3M8 15h3M8 19h3',
    layers: 'm3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5',
    pin: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM9.5 10a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0',
    focus: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 12h8M12 8v8',
    close: 'm6 6 12 12M6 18 18 6',
    arrow: 'M5 19 19 5M5 5h14v14',
    clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
