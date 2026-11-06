// Vite bundles imported stylesheets and images; TypeScript only needs to know the imports exist.
declare module '*.css';
declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.svg' {
  const url: string;
  export default url;
}
