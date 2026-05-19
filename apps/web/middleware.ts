import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './src/i18n/routing';

const intlMiddleware = createMiddleware(routing);
const localeLikeSegment = /^[a-z]{2}(?:-[a-z]{2})?$/i;

export default function middleware(request: NextRequest) {
  const [, firstSegment] = request.nextUrl.pathname.split('/');

  if (
    firstSegment &&
    localeLikeSegment.test(firstSegment) &&
    !routing.locales.includes(firstSegment as (typeof routing.locales)[number])
  ) {
    return NextResponse.next();
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)'
};
