// A full-page notice (remote access paused, no password set yet) that retries by itself.
import { t, translate } from './i18n.js';

translate();
const kind = document.querySelector('main').dataset.kind;
document.getElementById('text').textContent = t(`notice.${kind}`);
setTimeout(() => location.reload(), 15000);
