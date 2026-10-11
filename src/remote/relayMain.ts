// relay.html's entry: start the Relay with the token the instance injected
// (`window.__GGS_RELAY__`, set by remote_host.rs before the page loads).
import { startRelay } from './relay';

startRelay();
