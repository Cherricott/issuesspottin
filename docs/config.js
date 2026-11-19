// Cấu hình tự lưu feedback.
window.REVIEW_CONFIG = {
  // Chrome / Edge: ghi đè file feedback đã chọn sau mỗi lần bấm "Lưu câu này"
  // và định kỳ mỗi AUTOSAVE_SECONDS giây nếu có thay đổi.
  AUTOSAVE_SECONDS: 60,

  // Firefox / Safari (không ghi đè được file): tự tải file feedback mỗi N phút nếu có thay đổi.
  // Đặt 0 để tắt. Khi làm tiếp, mở file mới nhất.
  FALLBACK_DOWNLOAD_MINUTES: 5,
};
