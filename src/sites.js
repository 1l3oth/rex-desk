// Which environment a web address belongs to. The host lists mirror Flow's own getServerModeByHost, so Rex Desk
// calls exactly the sites production that the product itself calls production, and treats the rest as test servers.
const testHosts = ['develop.flow.team', 'staging.flow.team', 'release.flow.team', 'hotfix.flow.team',
  'develop.morningmate.com', 'staging.morningmate.com', 'release.morningmate.com', 'hotfix.morningmate.com',
  'morningmate.info', 'flowdev.info', 'flowteam.info', 'flowtest.info'];
const products = [['flow.team', 'Flow'], ['morningmate.com', 'Morningmate']];
const testLabel = /^(dev|develop|development|stage|staging|test|testing|qa|uat|sandbox|preview|release|hotfix|local|alpha|beta|demo)\d*$/;

export function siteEnvironment(address) {
  let host;
  try { host = new URL(String(address || '')).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return { environment: 'unknown', host: '' }; }
  const match = products.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  const site = { host, ...(match ? { product: match[1] } : {}) };
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^(127\.|10\.|192\.168\.|0\.0\.0\.0$)/.test(host)) return { ...site, environment: 'test' };
  if (testHosts.some(name => host === name || host.endsWith(`.${name}`))) return { ...site, environment: 'test' };
  const label = (match ? host.slice(0, Math.max(0, host.length - match[0].length - 1)) : host).split('.')[0];
  if (testLabel.test(label)) return { ...site, environment: 'test' };
  // A customer's own subdomain such as seco.flow.team is still the live service holding that customer's real data.
  return { ...site, environment: match ? 'production' : 'unknown' };
}
// The sign-in saved for a site: the closest host match, then the entry saved for any site.
export function accountForSite(accounts, address) {
  let host = '';
  try { host = new URL(String(address || '')).hostname.toLowerCase(); } catch {}
  const matches = site => { const value = String(site || '').trim(); return value && (host === value || host.endsWith(`.${value}`)); };
  return (accounts || []).find(account => matches(account.site))
    || (accounts || []).find(account => !String(account.site || '').trim()) || null;
}
export const isProductionSite = address => siteEnvironment(address).environment === 'production';
// Only a status that says the fix shipped puts it on production; "Development Completed" means it is on a test server.
export const releasedToProduction = status => /releas|deploy|shipped|live|production|배포|출시|운영/i.test(String(status || ''));
// The servers each product runs on, in the order a QA check should try them. The development server comes first
// because the saved test account is an account there; a server that does not load is skipped for the next one.
const environments = {
  Flow: [['development', 'https://flowdev.info'], ['development', 'https://develop.flow.team'], ['staging', 'https://staging.flow.team'],
    ['release', 'https://release.flow.team'], ['hotfix', 'https://hotfix.flow.team'], ['production', 'https://flow.team']],
  Morningmate: [['development', 'https://morningmate.info'], ['development', 'https://develop.morningmate.com'], ['staging', 'https://staging.morningmate.com'],
    ['release', 'https://release.morningmate.com'], ['hotfix', 'https://hotfix.morningmate.com'], ['production', 'https://morningmate.com']],
};
export const testSites = product => (environments[product] || environments.Morningmate).filter(([name]) => name !== 'production').map(([, url]) => url);
export const environmentMap = Object.entries(environments)
  .map(([product, list]) => `${product} runs at ${list.map(([name, url]) => `${name} ${url}`).join(', ')}`).join('. ') + '.';
