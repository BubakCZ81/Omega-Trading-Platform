export interface PointerCoordinateElement {
  offsetWidth: number;
  offsetHeight: number;
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
}

export interface LocalPointerPoint {
  x: number;
  y: number;
}

export function clientPointToElementLocal(
  element: PointerCoordinateElement,
  clientX: number,
  clientY: number,
): LocalPointerPoint {
  const rect = element.getBoundingClientRect();
  const width = element.offsetWidth || rect.width;
  const height = element.offsetHeight || rect.height;
  return {
    x: rect.width > 0 ? (clientX - rect.left) * width / rect.width : 0,
    y: rect.height > 0 ? (clientY - rect.top) * height / rect.height : 0,
  };
}
