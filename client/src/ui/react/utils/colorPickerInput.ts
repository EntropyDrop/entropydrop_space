export function triggerColorPickerInput(): void {
  if (typeof document === 'undefined') return;
  const input = (document.getElementById('active-color-picker-input') ||
    document.getElementById('selector-color-picker-input') ||
    document.querySelector('.palette-color-picker-input')) as HTMLInputElement | null;
  if (input) {
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      } else {
        input.click();
      }
    } catch {
      input.click();
    }
  }
}
