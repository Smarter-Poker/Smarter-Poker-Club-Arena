import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@components': path.resolve(__dirname, './src/components'),
            '@lib': path.resolve(__dirname, './src/lib'),
            '@hooks': path.resolve(__dirname, './src/hooks'),
            '@stores': path.resolve(__dirname, './src/stores'),
            '@types': path.resolve(__dirname, './src/types'),
            '@services': path.resolve(__dirname, './src/services'),
            '@arena': path.resolve(__dirname, './src/arena'),
        },
    },
    server: {
        port: 5173,
        host: true,
    },
    define: {
        // Prevent process errors in browser
        'process.env': {},
    }
})
