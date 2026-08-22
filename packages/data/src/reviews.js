import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args = {}) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

// --- Storefront (public) ---

/** Load visible reviews for a product */
export const loadProductReviews = (productId, { page = 1, pageSize = 50 } = {}) =>
  rpc('list_product_reviews', { p_product_id: productId, p_limit: pageSize, p_offset: (page - 1) * pageSize });

/** Submit or update a review (authenticated customer) */
export const submitProductReview = ({ productId, rating, body = '' }) =>
  rpc('submit_product_review', { p_product_id: productId, p_rating: rating, p_body: body });

// --- Admin ---

/** Admin: list all reviews with optional filters */
export const adminListReviews = ({ productId = null, visible = null, page = 1, pageSize = 50 } = {}) =>
  rpc('admin_list_reviews', { p_product_id: productId, p_visible: visible, p_limit: pageSize, p_offset: (page - 1) * pageSize });

/** Admin: toggle review visibility */
export const adminToggleReviewVisibility = (reviewId, visible) =>
  rpc('admin_toggle_review_visibility', { p_review_id: reviewId, p_visible: visible });

/** Admin: permanently delete a review */
export const adminDeleteReview = (reviewId) =>
  rpc('admin_delete_review', { p_review_id: reviewId });
