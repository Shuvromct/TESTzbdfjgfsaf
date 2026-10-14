export const metadata = {
  title: 'DIU Campus Legacy 25 — Implementation and Monitoring',
  description: 'Project DIU-CL25-2026. Task register, budget, approvals and site evidence.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#12306b" />
        <link rel="stylesheet" href={`/app.css?v=${process.env.NEXT_PUBLIC_BUILD_ID || 'dev'}`} />
      </head>
      <body>{children}</body>
    </html>
  );
}
