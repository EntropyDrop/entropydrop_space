type ConsoleLog = (...data: unknown[]) => void;

/**
 * Browser DevTools are a privileged surface: pasted code can read same-origin
 * data, including an API key when the player explicitly chose to remember it.
 */
export function logConsoleSecurityWarning(log: ConsoleLog = console.log.bind(console)): void {
  log(
    '%c⚠ SECURITY WARNING',
    'color:#ff453a;font-size:22px;font-weight:900;letter-spacing:0.04em;'
  );
  log(
    '%cDo not paste code here unless you understand and trust it.',
    'color:#fbbf24;font-size:14px;font-weight:700;'
  );
  log(
    'Malicious code can steal API keys, account information, and world data from localStorage and sessionStorage.'
  );
}
