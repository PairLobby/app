//! Worker entry point for a self-hosted relay on Celld or Cloudflare.

import {handleRelay} from './relay.js';
import type {RelayEnv} from './relay.js';

export {PairLobbyInviteDirectory} from './invite-directory.js';
export {PairLobbyRoom} from './room-object.js';

export default {
    fetch(request: Request, env: RelayEnv): Promise<Response> {
        return handleRelay(request, env);
    }
} satisfies ExportedHandler<RelayEnv>;
