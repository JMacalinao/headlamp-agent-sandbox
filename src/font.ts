import bold from './fonts/JetBrainsMonoNerdFontMono-Bold.woff2?inline';
import regular from './fonts/JetBrainsMonoNerdFontMono-Regular.woff2?inline';

const FAMILY = 'JetBrainsMono Nerd Font Mono';

export const TERMINAL_FONT = `"${FAMILY}", monospace`;

let ready: Promise<void> | undefined;

// Inlined rather than served: the plugin is one main.js and Headlamp gives it no stable URL
// of its own. Resolves either way; a face that fails leaves xterm on the monospace fallback.
export function ensureTerminalFont(): Promise<void> {
  ready ??= Promise.all(
    [
      [regular, '400'],
      [bold, '700'],
    ].map(async ([url, weight]) => {
      const face = new FontFace(FAMILY, `url(${url})`, { weight });
      document.fonts.add(await face.load());
    })
  ).then(
    () => undefined,
    (error: unknown) => {
      console.warn('Terminal font failed to load; using the browser monospace instead.', error);
    }
  );
  return ready;
}
