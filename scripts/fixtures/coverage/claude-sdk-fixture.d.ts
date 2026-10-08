/**
 * Hand-written fixture for the Claude extractor test: only the shape the
 * extractor reads (an `SDKMessage` union of object types with `type` and
 * `subtype` literals, one alias of a union, nested objects whose own `type`
 * must be ignored). Names follow the published SDK; nothing here is copied.
 */
export declare type SDKMessage = SDKAssistantMessage | SDKResultMessage | SDKAPIRetryMessage | SDKRateLimitEvent;

export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: {
        type: 'message';
        content: Array<{ type: 'text'; text: string }>;
    };
    session_id: string;
};

export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;

export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    usage: { type: 'usage'; input_tokens: number };
};

export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    errors: string[];
};

export declare type SDKAPIRetryMessage = {
    type: 'system';
    subtype: 'api_retry';
    attempt: number;
};

export declare type SDKRateLimitEvent = {
    type: 'rate_limit_event';
    rate_limit_info: { status: 'allowed' | 'rejected' };
};
