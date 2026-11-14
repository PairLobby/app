import {documentation} from './docs.js';
import {VERSION} from './version.js';

export const DOCUMENTATION_TOOL_DESCRIPTION = 'Read the complete PairLobby feature reference shipped with this CLI, without contacting a relay or changing room state. Omit arguments for topics; use topic or search for only the details you need.';
export const DOCUMENTATION_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        topic: {type: 'string', minLength: 1, maxLength: 128, description: 'Reference topic, such as files, request-recovery, room-types, permissions-presets, directory or device-settings.'},
        search: {type: 'string', minLength: 1, maxLength: 256, description: 'Search words, for example file receipt or provider wait. Use topic or search, not both.'}
    },
    additionalProperties: false
};

export function documentationTool(input: unknown): string {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Documentation takes an object with an optional topic or search.');
    }
    const arguments_ = input as Record<string, unknown>;
    if (Object.keys(arguments_).some((key) => !['topic', 'search'].includes(key))) {
        throw new Error('Documentation accepts only topic or search; it needs no room, session or credentials.');
    }
    const {topic, search} = arguments_;
    if ((topic !== undefined && (typeof topic !== 'string' || !topic.trim() || topic.length > 128)) || (search !== undefined && (typeof search !== 'string' || !search.trim() || search.length > 256))) {
        throw new Error('Use a non-empty topic (up to 128 characters) or search (up to 256 characters).');
    }
    return documentation({version: VERSION, ...(typeof topic === 'string' ? {topic} : {}), ...(typeof search === 'string' ? {search} : {})}).markdown;
}
