export const Env = {
    get GEMINI_API_KEY() {
        return import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.API_KEY || '';
    }
};
