import { useEffect, useCallback, useRef } from 'react';

export const useViewportHeight = () => {
  const rafId = useRef<number | null>(null);

  const handleResize = useCallback(() => {
    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
    }

    rafId.current = requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
      rafId.current = null;
    });
  }, []);

  useEffect(() => {
    // Set the initial height
    handleResize();

    // Modern API for viewport changes (preferred)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
    } else {
      // Fallback for older browsers
      window.addEventListener('resize', handleResize);
    }

    // Handle orientation changes
    window.addEventListener('orientationchange', handleResize);

    // Cleanup listeners on component unmount
    return () => {
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
      }
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
      } else {
        window.removeEventListener('resize', handleResize);
      }
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [handleResize]);
};
