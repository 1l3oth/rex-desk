// Settings: a quiet placeholder shown while a page waits on the server. Grey rows in the same grouped box the real rows use.
import { t } from './i18n.js';
export const skeletonHtml = (rows = 4) => `<div class="st-box st-skel" role="status" aria-busy="true" aria-label="${t`Loading`}">${Array.from({ length: rows }, (_, index) => `<div class="st-skel-row"><i class="st-skel-a" style="width:${[38, 52, 30, 46, 40][index % 5]}%"></i><i class="st-skel-b" style="width:${[64, 48, 72, 56, 60][index % 5]}%"></i></div>`).join('')}</div>`;
