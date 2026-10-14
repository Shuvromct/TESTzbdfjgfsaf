import Script from 'next/script';

/**
 * The client is one static file, served from /public. Everything it knows comes
 * from /api/state; everything it changes goes back one field at a time.
 */
export default function Page() {
  return (
    <>
      <div id="app" />
      <div className="toasts noprint" id="toasts" />
      <div className="madeby noprint">
        Project Office · Created by <b>Md Shafikul Islam Shuvro</b>
      </div>
      <Script src={`/app.js?v=${process.env.NEXT_PUBLIC_BUILD_ID || 'dev'}`} strategy="afterInteractive" />
    </>
  );
}
