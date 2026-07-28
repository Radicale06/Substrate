import { Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, isSupabaseConfigured } from '../config/env';

const logger = new Logger('SupabaseClient');

let client: SupabaseClient | null | undefined;

/**
 * The shared Supabase client, or null when the backend is not configured.
 *
 * Built lazily so a standalone install never constructs one, and cached so every
 * consumer shares a single connection pool.
 */
export function getSupabaseClient(): SupabaseClient | null {
    if (client !== undefined) {
        return client;
    }
    if (!isSupabaseConfigured()) {
        client = null;
        return client;
    }

    try {
        client = createClient(env.supabase.url!, env.supabase.serviceRoleKey!, {
            auth: {
                // A server-side service role has no session to persist or refresh.
                persistSession: false,
                autoRefreshToken: false,
            },
        });
    } catch (err: any) {
        // Construction can fail on its own (e.g. no native WebSocket on old Node). Never
        // let that reach a request: cache and Storage simply stay disabled.
        logger.error('Could not create the Supabase client; continuing without it', { err: err?.message });
        client = null;
    }

    return client;
}
