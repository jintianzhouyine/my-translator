// Only transport/service failures can be repaired by reconnecting. Keep account,
// configuration and protocol errors visible instead of repeatedly retrying them.
export function isRecoverableRealtimeError(code, message = '') {
    const text = `${code || ''} ${message || ''}`;
    if (/\b(?:400|401|402|403|404|405|415|422)\b|InvalidApiKey|InvalidParam|invalid[_ -]?(?:api[_ -]?key|parameter|argument|workspace|payload|input)|unauthori[sz]ed|forbidden|authentication|access.?denied|insufficient[_ -]?(?:quota|balance)|arrearage|quota.?exhaust|余额|欠费|无效.*(?:密钥|参数)|鉴权|没有权限|请填写/i.test(text)) return false;
    if (/\b(?:1002|1003|1007|1008|1009)\b/.test(text) && !/throttl|rate.?limit|限流/i.test(text)) return false;
    return /\b(?:408|429|5\d\d)\b|throttl|rate.?limit|timeout|timed.?out|network|connection|connect_failed|audio_send_failed|audio_backpressure|closed|finished|ServiceUnavailable|ModelServiceFailed|ECONN|socket|限流|超时|网络|连接|断开|积压/i.test(text);
}
