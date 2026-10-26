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
export const isProductionSite = address => siteEnvironment(address).environment === 'production';
// Only a status that says the fix shipped puts it on production; "Development Completed" means it is on a test server.
export const releasedToProduction = status => /releas|deploy|shipped|live|production|배포|출시|운영/i.test(String(status || ''));
// Where each product's fixes run before release, named so an agent kept off production knows where to go instead.
export const testSites = product => (product === 'Flow'
  ? ['https://develop.flow.team', 'https://staging.flow.team', 'https://release.flow.team', 'https://hotfix.flow.team']
  : ['https://develop.morningmate.com', 'https://staging.morningmate.com', 'https://release.morningmate.com', 'https://hotfix.morningmate.com']);
export const environmentMap = `Flow runs at ${['production https://flow.team', ...testSites('Flow').map(site => `${new URL(site).hostname.split('.')[0]} ${site}`)].join(', ')}. `
  + `Morningmate runs at ${['production https://morningmate.com', ...testSites('Morningmate').map(site => `${new URL(site).hostname.split('.')[0]} ${site}`)].join(', ')}.`;
