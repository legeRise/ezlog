/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    content: [
        './templates/**/*.html',
        './static/**/*.js',
    ],
    theme: {
        extend: {
            colors: {
                gray: {
                    900: '#1e1e1e',
                    800: '#252526',
                    700: '#333333',
                    600: '#3e3e42',
                    500: '#505050',
                },
                blue: { 500: '#007acc' },
                // Solarized colors
                solarized: {
                    base03: '#002b36', base02: '#073642', base01: '#586e75', base00: '#657b83',
                    base0: '#839496', base1: '#93a1a1', base2: '#eee8d5', base3: '#fdf6e3',
                    yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#d33682',
                    violet: '#6c71c4', blue: '#268bd2', cyan: '#2aa198', green: '#859900',
                },
            },
        },
    },
    plugins: [],
};
