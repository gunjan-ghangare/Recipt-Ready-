import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'info' | 'error'

export interface ToastApi {
  show(message: string, tone?: ToastTone): void
}

export const ToastContext = createContext<ToastApi>({ show: () => undefined })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
