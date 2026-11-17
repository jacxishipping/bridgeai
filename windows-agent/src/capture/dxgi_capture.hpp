#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace aibridge {
namespace capture {

struct MonitorDescriptor {
    int index = 0;
    std::string name;
    std::string device_name;
    std::string adapter_name;
    int left = 0;
    int top = 0;
    int right = 1920;
    int bottom = 1080;
    int width = 1920;
    int height = 1080;
    int rotation_degrees = 0;
    bool is_primary = false;
};

struct DirtyRect {
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;
};

struct CapturedFrame {
    bool valid = false;
    bool from_dxgi = false;
    bool secure_desktop_detected = false;
    // F08-05: machine-readable reason when valid == false
    // ("no_monitors" | "gdi_dc_failed" | "gdi_bitmap_failed" |
    // "gdi_blt_failed" | "gdi_dibits_failed" | ...). A failed capture is
    // reported as a failure, never as a black "valid" frame.
    std::string failure_reason;
    int width = 0;
    int height = 0;
    int stride = 0;
    int monitor_index = 0;
    int cursor_x = 0;
    int cursor_y = 0;
    bool cursor_visible = false;
    double capture_time_ms = 0.0;
    uint64_t timestamp_us = 0;
    std::vector<DirtyRect> dirty_rects;
    int move_rect_count = 0;
    std::vector<uint8_t> bgra_pixels; // Populated when CPU staging readout is requested
    Microsoft::WRL::ComPtr<ID3D11Texture2D> gpu_texture;
};

class DxgiDesktopCapturer {
public:
    DxgiDesktopCapturer();
    ~DxgiDesktopCapturer();

    bool Initialize(int monitor_index = 0);
    void Shutdown();

    std::vector<MonitorDescriptor> EnumerateMonitors() const;
    bool CaptureNextFrame(CapturedFrame& out_frame, int timeout_ms = 50, bool copy_to_cpu = true);
    bool CaptureWindow(HWND hwnd, CapturedFrame& out_frame) const;
    // F08-09: THE secure-desktop helper. One rule, shared with the
    // Python side (screen_capture.is_secure_desktop_name): secure iff
    // the input desktop's name is anything other than "Default"
    // (case-insensitive) — Winlogon, Disconnect, Screen-saver, or any
    // other non-default desktop — or OpenInputDesktop fails. Do not
    // add a second desktop-name list anywhere; change this helper.
    bool IsSecureDesktopActive() const;
    // F08-09: cached form for the per-frame call site. The desktop name
    // only changes on lock / UAC / session switch, so re-probing the
    // Win32 input desktop on every frame is waste; re-check at most
    // once per kSecureDesktopCacheTtl. CaptureNextFrame uses this.
    bool IsSecureDesktopActiveCached() const;

    int CurrentMonitorIndex() const { return current_monitor_; }
    ID3D11Device* GetD3D11Device() const { return d3d_device_.Get(); }
    ID3D11DeviceContext* GetD3D11Context() const { return d3d_context_.Get(); }

private:
    bool InitDuplicationLocked(int monitor_index);
    bool CaptureViaGdiFallbackLocked(int monitor_index, CapturedFrame& out_frame);

    mutable std::mutex mutex_;
    bool initialized_ = false;
    int current_monitor_ = 0;
    int output_width_ = 1920;
    int output_height_ = 1080;
    int rotation_degrees_ = 0;

    // F08-09: secure-desktop probe cache (see IsSecureDesktopActiveCached).
    static constexpr std::chrono::seconds kSecureDesktopCacheTtl{2};
    mutable bool secure_desktop_cache_valid_ = false;
    mutable bool secure_desktop_cached_ = false;
    mutable std::chrono::steady_clock::time_point secure_desktop_checked_at_{};
    // F08-11: monitor-enumeration cache. EnumerateMonitors() walks
    // DXGI adapters/outputs; the GDI fallback calls it on every frame,
    // so cache the list briefly (displays rarely change; 5 s TTL).
    static constexpr std::chrono::seconds kMonitorsCacheTtl{5};
    mutable bool monitors_cache_valid_ = false;
    mutable std::vector<MonitorDescriptor> monitors_cached_;
    mutable std::chrono::steady_clock::time_point monitors_checked_at_{};

    Microsoft::WRL::ComPtr<ID3D11Device> d3d_device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> d3d_context_;
    Microsoft::WRL::ComPtr<IDXGIOutputDuplication> desk_dupl_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging_texture_;
    std::vector<uint8_t> last_bgra_frame_;
};

} // namespace capture
} // namespace aibridge
