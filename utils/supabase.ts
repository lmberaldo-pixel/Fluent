import { createClient } from '@supabase/supabase-js';
import { Env } from './env';

export const supabase = createClient(
    Env.SUPABASE_URL,
    Env.SUPABASE_ANON_KEY
);

export const getGeminiKey = async (): Promise<string | null> => {
    try {
        const { data, error } = await supabase.functions.invoke('get-gemini-key');

        if (error) {
            console.error('Error invoking Edge Function get-gemini-key:', error);
            return null;
        }

        return data?.value || null;
    } catch (err) {
        console.error('Unexpected error calling Edge Function:', err);
        return null;
    }
};
