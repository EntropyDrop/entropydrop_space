type ConsoleLog = (...data: unknown[]) => void;

/**
 * Browser DevTools are a privileged surface: pasted code can read same-origin
 * data, including an API key when the player explicitly chose to remember it.
 */
export function logConsoleSecurityWarning(log: ConsoleLog = console.log.bind(console)): void {
  log(
    '%c⚠ SECURITY WARNING / 安全提醒',
    'color:#ff453a;font-size:22px;font-weight:900;letter-spacing:0.04em;'
  );
  log(
    '%c不要在控制台粘贴你不理解或不信任的代码。Do not paste code here unless you understand and trust it.',
    'color:#fbbf24;font-size:14px;font-weight:700;'
  );
  log(
    '恶意代码可能窃取 localStorage、sessionStorage 中的 API Key、账户信息和世界数据。Malicious code can steal API keys, account information, and world data from browser storage.'
  );
}
