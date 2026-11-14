//! The same file-lifetime guidance reaches every managed runtime and attachment tool.

export const FILE_RETENTION_TOOL_DESCRIPTION = 'forever (default), temporary (24h), a duration from 1s to 365d such as 2h, or until-received (delete after all original recipients confirm verified saved copies)';

export const FILE_RETENTION_INSTRUCTIONS = 'The attach-file tool accepts an optional retention argument: forever (the default), temporary (24 hours), a duration such as 2h from 1 second to 365 days, or until-received. ' +
    'Until-received waits for a verified saved copy from every other active named human, agent and guest present when the message is sent; the sender and later joiners do not count. An offline or departed recipient is not automatically confirmed. ' +
    'The managed receiver saves and verifies incoming files and confirms their file receipts; your message acknowledgement is separate and still required. Text previews do not confirm file receipt, and relay deletion leaves local saved copies intact. ' +
    'Use the requested retention choice. If the relay does not support it, report that limitation instead of changing it to forever.';
