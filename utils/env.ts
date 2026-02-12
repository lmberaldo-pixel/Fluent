export const Env = {
    get GEMINI_API_KEY() {
        return import.meta.env.VITE_GEMINI_API_KEY || '';
    },
    get SUPABASE_URL() {
        return import.meta.env.VITE_SUPABASE_URL || '';
    },
    get SUPABASE_ANON_KEY() {
        return import.meta.env.VITE_SUPABASE_ANON_KEY || '';
    }
};
