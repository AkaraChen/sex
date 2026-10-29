// page-script.js is imported as text (`with { type: "text" }`): Bun and the tsdown build both inline it as a string.
declare module "*.js" {
  const text: string;
  export default text;
}
