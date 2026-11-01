// Older settings have no completion flag. Existing engine configuration is
// enough to skip onboarding; credentials are checked separately when starting.
export function hasRememberedEngine(settings = {}) {
    if (settings.engine_selection_completed === true) return true;
    if (['local', 'openai', 'qwen'].includes(settings.translation_mode)) return true;
    return ['soniox_api_key', 'openai_api_key', 'qwen_api_key', 'qwen_workspace_id']
        .some(key => typeof settings[key] === 'string' && settings[key].trim().length > 0);
}
