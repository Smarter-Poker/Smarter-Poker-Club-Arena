// Small shared interface glyphs keep both native consumers dependency-free.
const icon = children => function DockIcon({ size = 20, ...props }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
};
export const X = icon(<path d="m6 6 12 12M18 6 6 18" />);
export const Minus = icon(<path d="M5 12h14" />);
export const Maximize2 = icon(<><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></>);
export const ExternalLink = Maximize2;
export const MessageCircle = icon(<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" />);
export const Settings = icon(<><circle cx="12" cy="12" r="3" /><path d="m10 3-1 3-3 1-3-1-1 4 3 2-1 3-2 2 3 3 3-2 3 1 1 3h4l1-3 3-1 3 1 1-4-3-2 1-3 2-2-3-3-3 2-3-1-1-3z" /></>);
export const Check = icon(<path d="m5 12 4 4L19 6" />);
export const Send = icon(<><path d="m22 2-7 20-4-9-9-4 20-7zM22 2 11 13" /></>);
export const ImagePlus = icon(<><rect x="3" y="3" width="15" height="18" rx="2" /><circle cx="8" cy="8" r="1" /><path d="m3 17 5-5 4 4 3-3 3 3M20 3v6M17 6h6" /></>);
export const Reply = icon(<path d="m9 5-7 7 7 7M2 12h12a7 7 0 0 1 7 7" />);
export const Smile = icon(<><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 3 4 3 4-3 4-3M8 8h.01M16 8h.01" /></>);
export const ThumbsUp = icon(<><path d="M7 10v11H3V10h4zm0 0 5-8h2v7h5a2 2 0 0 1 2 2l-2 9H7" /></>);
